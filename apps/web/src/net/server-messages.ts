// spec: docs/05 §4.2(S2C 메시지 전문 — 유일한 원천, docs/00 §11-D7)·§4.1(프레임 규약),
//       WT-M4-03(ws-manager "zod 파싱" 요구)
//
// 클라가 수신하는 서버 프레임(ServerMessage)의 런타임 파서. @wt/shared의 schemas.ts는 서버가
// 소비하는 C2S 스키마만 정의한다(서버는 자기 출력을 파싱하지 않으므로) — 클라 수신용 S2C 스키마는
// 존재하지 않아 여기서 정의한다. 타입 정의 자체(messages.ts)는 shared가 단일 원천이며, 아래는
// z.infer가 그 타입과 정확히 일치하는지 컴파일 타임에 강제한다(_Check* Assert<Equal<...>>) —
// messages.ts가 바뀌면 여기서 빌드가 깨져 이중 원천 표류를 방지한다.
import { z } from 'zod';
import type {
  PlayerPublic,
  ResultRow,
  ServerMessage,
  S2C_BotOffer,
  S2C_Chat,
  S2C_Countdown,
  S2C_CountryAccepted,
  S2C_CountryRejected,
  S2C_Error,
  S2C_PlayerFinished,
  S2C_ProgressTick,
  S2C_RaceFinished,
  S2C_RaceSync,
  S2C_RematchState,
  S2C_Results,
  S2C_RoomClosed,
  S2C_RoomState,
  S2C_Start,
  S2C_TimeSync,
  S2C_Welcome,
} from '@wt/shared';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const V1 = z.literal(1);
const NUM = z.number();
const STR = z.string();

const ConnState = z.enum(['connected', 'grace', 'left', 'spectator']);
const Lang = z.enum(['ko', 'en']);

const PlayerPublicSchema = z
  .object({
    playerId: STR,
    nickname: STR,
    passportCover: STR,
    bestPi: NUM.nullable(),
    isHost: z.boolean(),
    isBot: z.boolean(),
    ready: z.boolean(),
    connState: ConnState,
  })
  .strict();
type _CheckPlayerPublic = Assert<Equal<z.infer<typeof PlayerPublicSchema>, PlayerPublic>>;

const WelcomeSchema = z
  .object({
    v: V1,
    type: z.literal('welcome'),
    ack: NUM,
    playerId: STR,
    resumeKey: STR,
    serverTime: NUM,
    resumed: z.boolean(),
  })
  .strict();
type _CheckWelcome = Assert<Equal<z.infer<typeof WelcomeSchema>, S2C_Welcome>>;

const RoomStateSchema = z
  .object({
    v: V1,
    type: z.literal('room-state'),
    phase: z.enum(['WAITING', 'COUNTDOWN', 'RACING', 'FINISHED']),
    roomCode: STR,
    config: z
      .object({
        lang: Lang,
        mode: STR,
        poolParam: STR.nullable(),
        maxPlayers: NUM,
        isPublic: z.boolean(),
      })
      .strict(),
    players: z.array(PlayerPublicSchema),
    hostId: STR,
    autoStartAt: NUM.nullable(),
  })
  .strict();
type _CheckRoomState = Assert<Equal<z.infer<typeof RoomStateSchema>, S2C_RoomState>>;

const CountdownSchema = z
  .object({ v: V1, type: z.literal('countdown'), startAt: NUM, raceId: STR })
  .strict();
type _CheckCountdown = Assert<Equal<z.infer<typeof CountdownSchema>, S2C_Countdown>>;

const StartSchema = z
  .object({
    v: V1,
    type: z.literal('start'),
    raceId: STR,
    seed: STR,
    countries: z.array(STR),
    dataVersion: STR,
    startAt: NUM,
    hardCapAt: NUM,
    perCountryLimitMs: NUM,
  })
  .strict();
type _CheckStart = Assert<Equal<z.infer<typeof StartSchema>, S2C_Start>>;

const ProgressTickSchema = z
  .object({
    v: V1,
    type: z.literal('progress-tick'),
    at: NUM,
    players: z.array(
      z
        .object({
          id: STR,
          idx: NUM,
          ksPct: NUM,
          combo: NUM,
          state: z.enum(['racing', 'finished', 'grace', 'left']),
          rank: NUM.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
type _CheckProgressTick = Assert<Equal<z.infer<typeof ProgressTickSchema>, S2C_ProgressTick>>;

const CountryAcceptedSchema = z
  .object({
    v: V1,
    type: z.literal('country-accepted'),
    ack: NUM,
    idx: NUM,
    nextIdx: NUM,
    serverElapsedMs: NUM,
    combo: NUM,
    finished: z.boolean(),
    rank: NUM.nullable(),
  })
  .strict();
type _CheckCountryAccepted = Assert<Equal<z.infer<typeof CountryAcceptedSchema>, S2C_CountryAccepted>>;

const CountryRejectedSchema = z
  .object({
    v: V1,
    type: z.literal('country-rejected'),
    ack: NUM,
    idx: NUM,
    reason: z.enum(['WRONG_INDEX', 'NOT_EXACT', 'TOO_FAST', 'NOT_RACING', 'ALREADY_FINISHED']),
    authoritative: z
      .object({ nextIdx: NUM, serverElapsedMs: NUM, combo: NUM })
      .strict(),
  })
  .strict();
type _CheckCountryRejected = Assert<Equal<z.infer<typeof CountryRejectedSchema>, S2C_CountryRejected>>;

const PlayerFinishedSchema = z
  .object({
    v: V1,
    type: z.literal('player-finished'),
    playerId: STR,
    rank: NUM,
    elapsedMs: NUM,
    photoFinish: z.boolean(),
  })
  .strict();
type _CheckPlayerFinished = Assert<Equal<z.infer<typeof PlayerFinishedSchema>, S2C_PlayerFinished>>;

const RaceFinishedSchema = z
  .object({
    v: V1,
    type: z.literal('race-finished'),
    reason: z.enum(['all-finished', 'hardcap', 'all-left']),
  })
  .strict();
type _CheckRaceFinished = Assert<Equal<z.infer<typeof RaceFinishedSchema>, S2C_RaceFinished>>;

const ResultRowSchema = z
  .object({
    playerId: STR,
    nickname: STR,
    isBot: z.boolean(),
    rank: NUM,
    finished: z.boolean(),
    countriesCleared: NUM,
    elapsedMs: NUM.nullable(),
    cpm: NUM,
    acc: NUM,
    pi: NUM,
    disconnected: z.boolean(),
  })
  .strict();
type _CheckResultRow = Assert<Equal<z.infer<typeof ResultRowSchema>, ResultRow>>;

const ResultsSchema = z
  .object({
    v: V1,
    type: z.literal('results'),
    raceId: STR,
    rows: z.array(ResultRowSchema),
    rematchDeadline: NUM,
  })
  .strict();
type _CheckResults = Assert<Equal<z.infer<typeof ResultsSchema>, S2C_Results>>;

const RematchStateSchema = z
  .object({
    v: V1,
    type: z.literal('rematch-state'),
    votes: z.array(z.object({ playerId: STR, vote: z.boolean().nullable() }).strict()),
    deadline: NUM,
  })
  .strict();
type _CheckRematchState = Assert<Equal<z.infer<typeof RematchStateSchema>, S2C_RematchState>>;

const RaceSyncSchema = z
  .object({
    v: V1,
    type: z.literal('race-sync'),
    phase: z.enum(['COUNTDOWN', 'RACING', 'FINISHED']),
    start: StartSchema,
    me: z
      .object({ nextIdx: NUM, serverElapsedMs: NUM, combo: NUM, errorKeystrokes: NUM })
      .strict(),
    tick: ProgressTickSchema,
  })
  .strict();
type _CheckRaceSync = Assert<Equal<z.infer<typeof RaceSyncSchema>, S2C_RaceSync>>;

const TimeSyncSchema = z
  .object({ v: V1, type: z.literal('timesync'), ack: NUM, t0: NUM, t1: NUM })
  .strict();
type _CheckTimeSync = Assert<Equal<z.infer<typeof TimeSyncSchema>, S2C_TimeSync>>;

const BotOfferSchema = z
  .object({ v: V1, type: z.literal('bot-offer'), expiresAt: NUM })
  .strict();
type _CheckBotOffer = Assert<Equal<z.infer<typeof BotOfferSchema>, S2C_BotOffer>>;

const ChatSchema = z
  .object({ v: V1, type: z.literal('chat'), playerId: STR, text: STR, at: NUM })
  .strict();
type _CheckChat = Assert<Equal<z.infer<typeof ChatSchema>, S2C_Chat>>;

const RoomClosedSchema = z
  .object({
    v: V1,
    type: z.literal('room-closed'),
    reason: z.enum(['idle', 'empty', 'rematch-declined', 'error']),
  })
  .strict();
type _CheckRoomClosed = Assert<Equal<z.infer<typeof RoomClosedSchema>, S2C_RoomClosed>>;

const ErrorSchema = z
  .object({
    v: V1,
    type: z.literal('error'),
    ack: NUM.optional(),
    code: z.enum([
      'BAD_MESSAGE',
      'ROOM_FULL',
      'ROOM_NOT_FOUND',
      'WRONG_PHASE',
      'NOT_HOST',
      'DATA_VERSION',
      'RATE_LIMIT',
      'AUTH_FAILED',
      'NICKNAME_INVALID',
    ]),
    message: STR,
  })
  .strict();
type _CheckError = Assert<Equal<z.infer<typeof ErrorSchema>, S2C_Error>>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  RoomStateSchema,
  CountdownSchema,
  StartSchema,
  ProgressTickSchema,
  CountryAcceptedSchema,
  CountryRejectedSchema,
  PlayerFinishedSchema,
  RaceFinishedSchema,
  ResultsSchema,
  RematchStateSchema,
  RaceSyncSchema,
  TimeSyncSchema,
  BotOfferSchema,
  ChatSchema,
  RoomClosedSchema,
  ErrorSchema,
]);
type _CheckServerMessage = Assert<Equal<z.infer<typeof ServerMessageSchema>, ServerMessage>>;

export type ParseServerMessageResult =
  | { ok: true; data: ServerMessage }
  | { ok: false; error: string };

/**
 * 원문 WS 프레임(JSON 문자열)을 파싱해 판별 유니온으로 좁힌다. JSON 파싱 실패·스키마 위반
 * (초과 필드 포함, .strict())은 { ok:false }로 반환한다 — ws-manager는 이를 폐기하고 무시한다
 * (docs/05 §4.1: 파싱 불가 프레임 무시). ping/pong(Hibernation auto-response)은 애플리케이션
 * 레벨로 올라오지 않으므로 여기서 다루지 않는다.
 */
export function parseServerMessage(raw: string): ParseServerMessageResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = ServerMessageSchema.safeParse(json);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, data: result.data };
}
