// spec: docs/00 §7.4(KV 키 카탈로그 — 문자열 하드코딩 금지) + WT-M3-02
//
// KV(단일 네임스페이스, 프리픽스 운용 — docs/00 §7.2)에 쓰는 모든 키를 이 카탈로그로만
// 생성한다. 새 프리픽스가 필요하면 이 파일에 먼저 추가하고 docs/00 §7.4와 동기화할 것.

/** 정적(파라미터 없는) 키. */
export const KV_KEYS = {
  configClient: "config:client",
  configAnticheat: "config:anticheat",
  configModeration: "config:moderation",
  configBanner: "config:banner",
  configLobbyShards: "config:lobbyShards",
  dataCountriesOverride: "data:countries:override",

  /** 데일리 세트 캐시. dateKst = 'YYYY-MM-DD'(KST). */
  daily: (dateKst: string): string => `daily:${dateKst}`,

  /** 리더보드 top100 캐시. */
  lb: (boardKey: string): string => `lb:${boardKey}`,
  /** 리더보드 더티 마킹(TTL 180s). */
  dirty: (boardKey: string): string => `dirty:${boardKey}`,

  /**
   * 레이트리밋 고정윈도 카운터. scope는 mw/ratelimit.ts의 LIMITS 키(또는 세션 신규 pid
   * 어뷰징 카운터 같은 내부 하위스코프)와 정확히 일치시킨다. subject = pid 또는 IP 해시.
   */
  rateLimit: (scope: string, subject: string, windowStart: number): string =>
    `rl:${scope}:${subject}:${windowStart}`,

  /** IP 해시 차단(docs/04 §10.3 — 시간당 신규 pid 생성 > 20). */
  blockIp: (ipHash: string): string => `blk:ip:${ipHash}`,

  /** run 세션(runToken) 사용 플래그 — 재사용 방지(docs/06 §3.1). */
  session: (sid: string): string => `sess:${sid}`,

  /** 공개 방 목록(TTL 60s). */
  publicRoom: (code: string): string => `publicroom:${code}`,
  /** 공개 방 KV list 프리픽스(MatchRoom이 publicRoom(code)로 쓴 항목들). */
  publicRoomPrefix: "publicroom:",
  /** GET /rooms/public 조립 결과 3초 캐시(§2.4 "표시용 데이터"). publicroom: 프리픽스와 분리. */
  publicRoomsListCache: "cache:publicrooms",

  /** 고스트 봇 리플레이. */
  ghost: (lang: string, mode: string, piBucket: string): string =>
    `ghost:${lang}:${mode}:${piBucket}`,

  /** GET /users/:id/passport 60초 캐시(docs/06 §4.3, WT-M5-03). */
  passport: (userId: string): string => `passport:${userId}`,

  /** 마지막 방문일(KST 'YYYY-MM-DD') — retention_ping D1/D7/D30 코호트 판정용(WT-M6-03).
   *  D1 users 테이블에 컬럼을 추가하지 않고 KV에 두는 이유: 매 bootstrap마다 갱신되는
   *  고빈도 값이라 D1 UPDATE보다 KV가 저렴하고, 실패해도 리텐션 지표 정밀도만 낮아질 뿐
   *  기능에 영향이 없다(§11-D9 D1=canonical 원칙과 배치되지 않는 순수 분석 보조 데이터). */
  lastVisit: (pid: string): string => `visit:last:${pid}`,

  /** 일별 runs/start·submit 카운터(game_abandon 근사 집계, WT-M6-03 cron/retention.ts).
   *  dateKst = start/submit가 실제로 일어난 KST 날짜. */
  telStarts: (dateKst: string): string => `tel:starts:${dateKst}`,
  telSubmits: (dateKst: string): string => `tel:submits:${dateKst}`,
} as const;
